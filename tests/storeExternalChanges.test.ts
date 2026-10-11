import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { MusicStore } from '../src/store'
import config from '../config.json'

const track = (id: string) => ({ id, file: `Music/${id}.mp3`, title: id, artist: 'Forest' })

function fixture() {
  const mock = createMockValleyApi({
    manifest: { id: 'music', indexState: 'scoped', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] },
    settings: { musicPath: '' },
    datasets: {
      'music.tracks': [track('fern'), track('moss')],
      'music.playlists': [{ id: 'mix', name: 'Mix', cover: null }],
      'music.playlist_tracks': [{ playlistId: 'mix', trackId: 'fern', position: 0 }]
    }
  })
  mock.api.backend.call = vi.fn(async () => { throw new Error('No playback in this test') }) as typeof mock.api.backend.call
  return { mock, store: new MusicStore(mock.api) }
}

describe('MusicStore follows backend dataset writes', () => {
  it('lists a track another owner wrote without refresh()', async () => {
    const { mock, store } = fixture()
    try {
      await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ loading: false, tracks: [expect.anything(), expect.anything()] }))
      await mock.api.data.dataset('music.tracks').upsert(track('step8-play'))
      await vi.waitFor(() => expect(store.getSnapshot().tracks.map(value => value.id)).toContain('step8-play'))
      await mock.api.data.dataset('music.tracks').delete({ id: 'moss' })
      await vi.waitFor(() => expect(store.getSnapshot().tracks.map(value => value.id)).not.toContain('moss'))
    } finally { await store.dispose() }
  })

  it('edits a playlist after an external playlist update instead of reporting a revision conflict', async () => {
    const { mock, store } = fixture()
    try {
      await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
      await mock.api.data.dataset('music.playlists').upsert({ id: 'mix', name: 'Restored mix', cover: null })
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].name).toBe('Restored mix'))
      await store.updatePlaylistProperties('mix', { name: 'Renamed mix' })
      expect(await mock.api.data.dataset('music.playlists').get({ id: 'mix' })).toMatchObject({ name: 'Renamed mix' })
      expect(store.getSnapshot().playlists[0]).toMatchObject({ name: 'Renamed mix', songIds: ['fern'] })
    } finally { await store.dispose() }
  })

  it('stops following datasets after dispose', async () => {
    const { mock, store } = fixture()
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    await store.dispose()
    const query = vi.spyOn(mock.api.data, 'dataset')
    await mock.api.data.dataset('music.tracks').upsert(track('late'))
    query.mockClear()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(query).not.toHaveBeenCalled()
  })
})
