/**
 * Music — the vault music library and player as a fully disk-loaded plugin.
 * Library data flows through plugin-isolated track, playlist, play-event,
 * artist, and queue datasets; playback registers with the core controller through
 * `api.playback`, so the footer mini player, volume slider and OS media keys
 * keep working with zero music-specific code in the host.
 *
 * Three views: `music.panel` (left_sidebar), `music.player` (right_sidebar) and
 * `music.page` (main_workspace — the Spotify-style page with playlists, covers,
 * recently played, most listened, search and folder rescan).
 */
import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import {
  AGENT_TOOL_PROVIDER_V1,
  PLUGIN_METADATA_V1,
  WORKSPACE_VIEW_STATE_V1
} from '@valley/plugin-sdk'
import { musicMetadataProvider } from './metadata'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { createStore, disposeStore } from './store'
import { registerMusicCommands } from './commands'
import { NowPlaying, registerMusicSurfaces } from './surfaces'
import { registerMusicFence } from './fence'
import { Panel } from './Panel'
import { Player } from './Player'
import { Page } from './Page'
import { Settings } from './Settings'
import { initLocalization } from './localization'
import { musicAgentTools } from './agentTools'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()

  // Views observe the persistent backend's queue and host media session.
  const store = createStore(api)
  const offOwnLink = api.workspace.onOpenOwnLink((state) => {
    store.applyLinkState(state)
  })

  api.registerView('music.panel', Panel)
  api.registerView('music.player', Player)
  api.registerView('music.page', Page)
  api.registerView('music.settings', Settings)
  api.registerView('music.nowPlaying', NowPlaying)

  const offCommands = registerMusicCommands(api)
  const offSurfaces = registerMusicSurfaces(api, store)
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, musicAgentTools(api))
  const offFence = registerMusicFence()

  // Music owns no file extension, so the manifest alone cannot say what it is
  // doing. Read from the live snapshot at render time.
  const offMetadata = api.interop.extensions.provide(
    PLUGIN_METADATA_V1,
    musicMetadataProvider(store.getSnapshot)
  )
  const offWorkspaceViews = [
    api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, {
      id: 'music.main',
      surface: 'main_workspace',
      capture: store.captureMainWorkspaceView,
      restore: store.restoreMainWorkspaceView,
      subscribe: store.subscribeWorkspaceViewState
    }),
    api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, {
      id: 'music.left',
      surface: 'left_sidebar',
      capture: store.captureLeftWorkspaceView,
      restore: store.restoreLeftWorkspaceView,
      subscribe: store.subscribeWorkspaceViewState
    }),
    api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, {
      id: 'music.right',
      surface: 'right_sidebar',
      capture: store.captureRightWorkspaceView,
      restore: store.restoreRightWorkspaceView,
      subscribe: store.subscribeWorkspaceViewState
    })
  ]

  return () => {
    offOwnLink()
    offWorkspaceViews.forEach((off) => off())
    offMetadata()
    offCommands()
    offSurfaces()
    offAgentTools()
    offFence()
    disposeStyles()
    return disposeStore(api, store)
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
