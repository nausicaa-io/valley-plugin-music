/**
 * What Music publishes about itself to Settings → Metadata.
 *
 * Music owns no file extension — it is not a `.md` or a `.quiz`, it just plays
 * what is in the vault — but it still has metadata worth showing: which folder
 * it scanned, how much it found, and which media extensions it treats as songs.
 * Identity (version, author, data files, search sources) core reads off the
 * manifest; this is the part only the running plugin knows.
 *
 * Pure over the snapshot so it is unit-testable without an audio engine.
 */
import type { PluginMetadataFact, PluginMetadataProvider } from '@valley/plugin-sdk'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '@valley/plugin-sdk/fileTypes'
import type { MusicSnapshot } from './store'
import { musicCount } from './localization'

export function musicFacts(snapshot: MusicSnapshot): PluginMetadataFact[] {
  const missing = snapshot.missing.size
  return [
    {
      id: 'music.library',
      labelKey: 'plugin.music.meta.library',
      label: 'Library folder',
      value: snapshot.musicPath
    },
    {
      id: 'music.contents',
      labelKey: 'plugin.music.meta.contents',
      label: 'Indexed',
      value: [
        musicCount(snapshot.tracks.length, 'song'),
        musicCount(snapshot.artists.length, 'artist'),
        musicCount(snapshot.playlists.length, 'playlist')
      ].join(' · ')
    },
    // Only worth a line when it is not zero — a healthy library should not carry
    // a permanent "0 missing" row.
    ...(missing > 0
      ? [
          {
            id: 'music.missing',
            labelKey: 'plugin.music.meta.missing',
            label: 'Missing files',
            value: String(missing)
          }
        ]
      : []),
    {
      id: 'music.formats',
      labelKey: 'plugin.music.meta.formats',
      label: 'Media formats',
      value: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].join(' ')
    }
  ]
}

/** The descriptor `register()` hands to the `metadata.plugin` point. `facts()`
 *  reads the snapshot at render time, so a rescan shows up without re-registering. */
export function musicMetadataProvider(
  readSnapshot: () => MusicSnapshot
): PluginMetadataProvider {
  return {
    id: 'music.metadata',
    labelKey: 'plugin.music.name',
    label: 'Music',
    icon: 'music',
    facts: () => musicFacts(readSnapshot())
  }
}
