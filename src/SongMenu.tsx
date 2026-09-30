import { React, api } from './runtime'
import { useMusic } from './hooks'
import type { Track } from './types'
import { Copy, Pencil, ValleyIcon, FolderOpen, ListMusic, ListPlus, PanelLeftOpen, Pause, Play, Plus, Shuffle, Trash } from './icons'
import { SongEditor } from './SongEditor'
import { uiText } from './localization'

export function useSongMenu(onRemove?: (track: Track) => void): {
  openSongMenu: (e: React.MouseEvent, track: Track) => void
  songEditor: React.ReactNode
} {
  const { store, snap } = useMusic(false)
  const [editing, setEditing] = React.useState<Track | null>(null)

  const openSongMenu = (e: React.MouseEvent, track: Track): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!store) return
    const point = { x: e.clientX, y: e.clientY }
    const vaultPath = api.getState().vault?.path
    void api.ui.openMenu([
      { label: uiText('auto.3f661e5cfad7'), icon: <ListPlus />, onSelect: () => store.addToQueue(track, 'next') },
      { label: uiText('auto.f0ad6eb7a669'), icon: <ListPlus />, onSelect: () => store.addToQueue(track, 'end') },
      {
        label: uiText('auto.3e241e3cc63e'),
        icon: <Plus />,
        submenu: [
          {
            label: uiText('music.menu.newPlaylistFromSong'),
            icon: <ListMusic />,
            onSelect: () => store.createPlaylist(track.title, [track.id])
          },
          ...(snap.playlists.length ? [{ type: 'separator' as const }] : []),
          ...snap.playlists.map((playlist) => {
            const member = playlist.songIds.includes(track.id)
            return {
              label: playlist.name,
              icon: <ListMusic />,
              enabled: !member,
              checked: member,
              type: 'checkbox' as const,
              onSelect: () => store.addToPlaylist(playlist.id, track.id)
            }
          })
        ]
      },
      { type: 'separator' },
      { label: uiText('music.edit.title'), icon: <Pencil />, onSelect: () => setEditing(track) },
      {
        label: uiText('auto.7a00342a5213'),
        icon: <ValleyIcon />,
        onSelect: () => api.workspace.openFile(track.file)
      },
      { label: api.files.revealLabel(), icon: <FolderOpen />, onSelect: () => api.files.revealInFinder(track.file) },
      { label: uiText('music.menu.showInFiles'), icon: <PanelLeftOpen />, onSelect: () => api.workspace.revealInFiles(track.file) },
      { label: uiText('auto.75586047078a'), icon: <Copy />, onSelect: () => navigator.clipboard.writeText(track.file) },
      {
        label: uiText('auto.b96d429c4495'),
        icon: <Copy />,
        onSelect: () => navigator.clipboard.writeText(vaultPath ? `${vaultPath}/${track.file}` : track.file)
      },
      ...(onRemove ? [
        { type: 'separator' as const },
        {
          label: uiText('auto.ad3e5d8c1ce8'),
          icon: <Trash />,
          danger: true,
          onSelect: () => api.ui.openMenu([
            { label: uiText('auto.77dfd2135f4d') },
            { label: uiText('auto.ad3e5d8c1ce8'), danger: true, onSelect: () => onRemove(track) }
          ], point)
        }
      ] : [])
    ], point)
  }

  return { openSongMenu, songEditor: editing && store ? <SongEditor track={editing} store={store} onClose={() => setEditing(null)} /> : null }
}

export function usePlaylistMenu(): {
  openPlaylistMenu: (e: React.MouseEvent, playlistId: string) => void
} {
  const { store, snap } = useMusic(false)

  const openPlaylistMenu = (e: React.MouseEvent, playlistId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!store) return
    store.setFocusedPlaylist(playlistId)
    const tracks = snap.playlistTracks[playlistId] ?? []
    const enabled = tracks.length > 0
    const isCurrentlyPlaying = snap.isPlaying && snap.currentPlaylistId === playlistId
    void api.ui.openMenu([
      {
        label: isCurrentlyPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c'),
        icon: isCurrentlyPlaying ? <Pause /> : <Play />,
        enabled,
        onSelect: () => (isCurrentlyPlaying ? store.togglePlay() : store.playQueue(tracks, 0, playlistId))
      },
      { label: uiText('auto.5b772b7bfd0a'), icon: <Shuffle />, enabled, onSelect: () => store.playShuffledQueue(tracks, playlistId) },
      { label: uiText('auto.3f661e5cfad7'), icon: <ListPlus />, enabled, onSelect: () => store.addTracksToQueue(tracks, 'next') },
      { label: uiText('auto.f0ad6eb7a669'), icon: <ListPlus />, enabled, onSelect: () => store.addTracksToQueue(tracks, 'end') }
    ], { x: e.clientX, y: e.clientY })
  }

  return { openPlaylistMenu }
}
