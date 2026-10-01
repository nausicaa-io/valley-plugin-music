import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { MusicLibrary } from '../library'
import type { Track } from '../types'

const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid Music command input')
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum = 4096, empty = false): string => { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || value.includes('\0')) throw new Error('Invalid Music text'); return value }
const revision = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Expected revision is required'); return value }
const ids = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid playlist members'); const result = value.map(value => text(value, 256)); if (new Set(result).size !== result.length) throw new Error('Duplicate playlist members'); return result }
const expected = (input: Record<string, unknown>) => ({ revision: revision(input.expectedRevision), membersRevision: revision(input.expectedMembersRevision) })
const details = (value: unknown): Track['details'] => {
  const result = object(value, ['feat', 'songwriter', 'author', 'composer', 'genre', 'year', 'lyrics', 'cover', 'edited'])
  for (const [key, value] of Object.entries(result)) {
    if (key === 'edited') { if (typeof value !== 'boolean') throw new Error('Invalid metadata flag') }
    else text(value, key === 'lyrics' ? 200000 : 4096, true)
  }
  return result as Track['details']
}

export function libraryHandlers(): Record<string, (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>> {
  const run = (work: (library: MusicLibrary, input: unknown, context: PluginBackendOperationContext) => Promise<unknown>) => async (input: unknown, context: PluginBackendOperationContext) => {
    context.cancellation.throwIfAborted()
    const library = new MusicLibrary(context.api, path => context.api.media.readMetadata(path))
    return work(library, input, context)
  }
  return {
    'command.library.list': run(async (library, value) => {
      const input = object(value, ['kind', 'cursor', 'limit'])
      if (!['tracks', 'playlists', 'artists'].includes(String(input.kind))) throw new Error('Unknown library collection')
      return library.list(input.kind as 'tracks' | 'playlists' | 'artists', input.cursor === undefined ? undefined : text(input.cursor, 4096), input.limit === undefined ? 100 : revision(input.limit))
    }),
    'command.track.read': run((library, value) => { const input = object(value, ['id']); return library.readTrack(text(input.id, 256)) }),
    'command.track.update': run((library, value) => {
      const input = object(value, ['id', 'expectedRevision', 'patch']), patch = object(input.patch, ['title', 'artist', 'album', 'details', 'favorite'])
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'details') details(value)
        else if (key === 'favorite') { if (typeof value !== 'boolean') throw new Error('Invalid favorite state') }
        else text(value, 4096, key !== 'title')
      }
      return library.updateTrack(text(input.id, 256), patch, revision(input.expectedRevision))
    }),
    'command.track.delete': run((library, value) => { const input = object(value, ['id', 'expectedRevision']); return library.deleteTrack(text(input.id, 256), revision(input.expectedRevision)) }),
    'command.playlist.read': run((library, value) => { const input = object(value, ['id']); return library.readPlaylist(text(input.id, 256)) }),
    'command.playlist.create': run(async (library, value) => {
      const input = object(value, ['id', 'name', 'cover', 'songIds', 'expectedRevision', 'expectedMembersRevision']), id = text(input.id, 256)
      const observed = await library.readPlaylist(id)
      if (observed.value) throw new Error('Playlist already exists')
      return library.writePlaylist({ id, name: text(input.name, 4096), songIds: input.songIds === undefined ? [] : ids(input.songIds), ...(input.cover === undefined ? {} : { cover: text(input.cover, 4096, true) }) }, expected(input))
    }),
    'command.playlist.update': run(async (library, value) => {
      const input = object(value, ['id', 'expectedRevision', 'expectedMembersRevision', 'patch']), id = text(input.id, 256), patch = object(input.patch, ['name', 'cover', 'songIds'])
      const observed = await library.readPlaylist(id)
      if (!observed.value) throw new Error('Playlist no longer exists')
      const next = { ...observed.value }
      if (patch.name !== undefined) next.name = text(patch.name, 4096)
      if (patch.cover === null) delete next.cover
      else if (patch.cover !== undefined) next.cover = text(patch.cover, 4096, true)
      if (patch.songIds !== undefined) next.songIds = ids(patch.songIds)
      return library.writePlaylist(next, expected(input))
    }),
    'command.playlist.delete': run((library, value) => { const input = object(value, ['id', 'expectedRevision', 'expectedMembersRevision']); return library.deletePlaylist(text(input.id, 256), expected(input)) }),
    'command.artist.read': run((library, value) => { const input = object(value, ['id']); return library.readArtist(text(input.id, 256)) }),
    'command.artist.update': run((library, value) => {
      const input = object(value, ['id', 'expectedRevision', 'expectedAliasesRevision', 'patch']), patch = object(input.patch, ['name', 'image', 'bio'])
      for (const [key, value] of Object.entries(patch)) { if (value === null && key !== 'name') continue; text(value, key === 'bio' ? 200000 : 4096, key !== 'name') }
      return library.updateArtist(text(input.id, 256), patch, { revision: revision(input.expectedRevision), aliasesRevision: revision(input.expectedAliasesRevision) })
    }),
    'command.artist.rename': run((library, value) => {
      const input = object(value, ['id', 'expectedRevision', 'expectedAliasesRevision', 'name'])
      return library.updateArtist(text(input.id, 256), { name: text(input.name, 4096) }, { revision: revision(input.expectedRevision), aliasesRevision: revision(input.expectedAliasesRevision) })
    }),
    'command.artist.merge': run((library, value) => {
      const input = object(value, ['sourceId', 'targetId', 'expectedSourceRevision', 'expectedTargetRevision', 'expectedAliasesRevision'])
      return library.mergeArtists(text(input.sourceId, 256), text(input.targetId, 256), { sourceRevision: revision(input.expectedSourceRevision), targetRevision: revision(input.expectedTargetRevision), aliasesRevision: revision(input.expectedAliasesRevision) })
    }),
    'command.library.rescan': run((library, value, context) => { const input = object(value, ['expectedRevision']); return library.rescan(revision(input.expectedRevision), context.cancellation) })
  }
}
