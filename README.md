# Music

Music library and player with workspace-aware browser, panel, and player views that never roll back live playlists, queues, or playback.

Version 3 targets Valley plugin API 5 and uses SDK 6, tools 5, and testkit 6. Existing library data requires no migration. Valley’s persistent media runtime streams local files and prepares the next queued track without reading or decoding the entire file. Music’s backend owns queue advancement, shuffle, repeat, and play history, so closing application windows leaves local playback running. Queue transitions follow confirmed end events and are not sample-accurate gapless transitions. Playlist and artist relationships load every page; writes remain atomic. Removing more relationships than the host's 1,000-operation transaction limit reports an error without partially saving them.

## Install

Copy this repository into `<vault>/.valley/plugins/packages/local/music` or install its GitHub repository in Valley's plugin settings. The compiled `runtime/index.js` is included; Valley does not install dependencies or compile plugins on load.

## Development

Use Node 24.19.0 and npm 11.17.0. Run `npm ci` and `npm run check` in this directory. The package owns its dependencies, tests, localization, and vendored SDK/tool/testkit archives; no Valley app checkout is required. `npm run check` validates imports, types, tests, and builds `runtime/index.js`. Commit rebuilt runtime files with source changes.

## Song editing and playback

Right-click a song and choose **Edit song** to change its title, artist, album, featured artists, songwriter, author, composer, genre, year, lyrics, or cover. Covers can come from vault images, the image chooser, or drag and drop. Metadata is saved in Music’s library, without rewriting media-file tags. Rescanning preserves these edits; a stale editor reports a conflict instead of overwriting newer metadata.

The backend command catalog exposes `library.list/rescan`, `track.read/update/delete`, `playlist.read/create/update/delete`, and `artist.read/update/rename/merge` without opening a Music view. Read before editing and pass the returned `revision` as `expectedRevision`; playlist changes also require `expectedMembersRevision` from `playlist.read`. Artist edits require `expectedAliasesRevision`; merges require both artists’ revisions as `expectedSourceRevision` and `expectedTargetRevision`. Rescans require the tracks collection revision from `library.list`. These commands share the UI’s library operations, read embedded media tags, and save related dataset changes atomically. Deleting a track preserves its media file. Renaming keeps the previous artist name as an alias, while merging preserves target metadata and fills missing artwork or biography from the source. The UI’s undo history remains attached to its view.

The main page has centered playlist/song breadcrumbs and a separate Home/Search row, each 38px including its bottom border. Right-click the breadcrumb to switch to the vault-relative Music file path; this preference is saved. Video tracks offer Song and Video modes in one segmented control in the right sidebar. The switch matches the standard input height inside a 38px row. Media begins 5px below it in a shared square, height-capped frame; changing modes keeps the title, artist, and controls stationary. Covers fill the frame and videos preserve their proportions without an added black background. The host MediaSurface presents the same media element used for audio, including when presentation moves to PiP or another window. Shared transport commands wait for the host; an unknown outcome is shown without retrying playback. Music’s Stop also clears the upcoming queue.

Enable **Music** in Footer Rail settings for a cover-and-title button that opens the right-sidebar player. Music’s Footer details picker offers song, playlist, artist, favourite, queue, and known-duration totals. Library lists skip playback-clock renders, search results are memoized, and rescans use indexed path membership.

Music’s details panel presents plain key/value rows, cover paths, total duration, and per-artist song counts and minutes. Collaborations count their full duration for each credited artist, with aliases deduplicated per song; unknown durations are listed separately. The leading `/` breadcrumb returns to Home.

Home’s header includes the active song while playing or paused. Recently played cards keep their order for the session, refreshing on library refresh or plugin reload while play history continues updating.

## Workflow integration

The backend explicitly registers its supported blocks through `registerWorkflowContribution`. Workflow calls the owning operations with their original authentication, cancellation, grants, revisions, and receipts. The catalogue publishes Draft-07 parameter and port contracts; credential administration and approval bypasses are excluded. Workflow availability is configured separately in Workflow → Plugins. Existing account, connection, and profile settings remain owned by this plugin.

Workflow output collections are explicit: `library.list` → `$.rows`. Selectors are relative to each execution item’s `json`. Library listing deliberately selects rows, preserving parallel row revisions and the collection revision as metadata. Playback snapshots, nullable playlists, song IDs, artist aliases and rescan findings have no collection selector.
