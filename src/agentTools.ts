import {
  createAgentToolProvider,
  type AgentToolExecutionContext,
  type AgentToolProvider,
  type ValleyPluginApi
} from '@valley/plugin-sdk'

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false
})
const text = (description: string) => ({ type: 'string', description })
const str = (value: unknown) => value == null ? '' : String(value)
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined

async function execute(api: ValleyPluginApi, id: string, input: unknown, context?: AgentToolExecutionContext): Promise<unknown> {
  const result = await api.commands.executeOwn(id, input, { ...context, autonomous: true })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const render = (value: unknown): string => value === undefined ? 'Done.' : JSON.stringify(value, null, 2)

export function musicAgentTools(api: ValleyPluginApi): AgentToolProvider {
  return createAgentToolProvider([
    {
      name: 'music_play', description: 'Play or queue a track, artist match, or playlist. Use this directly for play requests without listing commands or asking the user to open Music. Omit unknown optional arguments instead of string placeholders such as null. After success, report the actual result briefly.',
      parameters: schema({
        title: text('Track title'), artist: text('Artist'), query: text('Natural music query'),
        playlist: text('Playlist name'), queue: { type: 'string', enum: ['now', 'next', 'last'] },
        shuffle: { type: 'boolean' }, random: { type: 'boolean' }, exact: { type: 'boolean' }
      }),
      sideEffect: 'read', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const queue = str(args.queue) || 'now'
        const playlist = str(args.playlist)
        if (args.shuffle === true) await execute(api, 'shuffle', { mode: 'on' }, context)
        if (playlist) {
          const id = queue === 'next' ? 'playlist-next' : queue === 'last' ? 'playlist-last' : 'playlist'
          return render(await execute(api, id, { name: playlist, shuffle: args.shuffle === true }, context))
        }
        const title = str(args.title) || str(args.query) || str(args.artist)
        if (!title) return 'Provide a track, artist, query, or playlist.'
        const id = queue === 'next' ? 'play-next' : queue === 'last' ? 'play-last' : 'play'
        return render(await execute(api, id, { title, exact: args.exact === true }, context))
      }
    },
    {
      name: 'music_library', description: 'Inspect tracks, artists, playlists, queue, or current playback. Use this for library questions and artist or playlist searches instead of searching vault files.',
      parameters: schema({
        kind: { type: 'string', enum: ['tracks', 'artists', 'playlists', 'queue', 'now'] }, query: text('Search term')
      }, ['kind']),
      sideEffect: 'read', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const ids: Record<string, string> = {
          tracks: 'library', artists: 'artists', playlists: 'playlists', queue: 'queue', now: 'now'
        }
        return render(await execute(api, ids[str(args.kind)] ?? 'library', { search: str(args.query) }, context))
      }
    },
    {
      name: 'music_open', description: 'Open a Music artist, playlist, song artist, or the Music home without playing.',
      parameters: schema({
        kind: { type: 'string', enum: ['artist', 'playlist', 'song-artist', 'page'] },
        name: text('Name'), artist: text('Artist'), playlist: text('Playlist'), song: text('Song title')
      }, ['kind']),
      sideEffect: 'read', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const kind = str(args.kind)
        const id = kind === 'artist' ? 'open-artist' : kind === 'playlist' ? 'open-playlist'
          : kind === 'song-artist' ? 'open-song-artist' : 'open-page'
        const value = str(args.name) || str(args.artist) || str(args.playlist) || str(args.song)
        return render(await execute(api, id, value ? { name: value, title: value } : undefined, context))
      }
    },
    {
      name: 'music_control', description: 'Pause, resume, skip, stop, adjust volume, or shuffle current music playback. Use this directly for transport requests.',
      parameters: schema({
        action: { type: 'string', enum: ['play', 'resume', 'pause', 'next', 'previous', 'stop', 'shuffle', 'volume'] },
        enabled: { type: 'boolean' }, volume: { type: 'number' }
      }, ['action']),
      sideEffect: 'read', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const action = str(args.action)
        const id = action === 'play' ? 'resume' : action === 'next' ? 'skip' : action === 'previous' ? 'back' : action
        const input = id === 'shuffle' ? { mode: bool(args.enabled) === undefined ? 'toggle' : args.enabled ? 'on' : 'off' }
          : id === 'volume' ? { level: Number(args.volume) } : undefined
        return render(await execute(api, id, input, context))
      }
    },
    {
      name: 'music_queue', description: 'Add, remove, clear, or list the up-next queue.',
      parameters: schema({
        action: { type: 'string', enum: ['add', 'remove', 'clear', 'list'] }, title: text('Track title'),
        playlist: text('Playlist'), position: { type: 'string', enum: ['next', 'last'] }, index: { type: 'number' }
      }, ['action']),
      sideEffect: 'read', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const action = str(args.action)
        if (action === 'list') return render(await execute(api, 'queue', undefined, context))
        if (action === 'clear') return render(await execute(api, 'clear-queue', undefined, context))
        if (action === 'remove') return render(await execute(api, 'remove-from-queue', { title: str(args.title), index: args.index }, context))
        const suffix = str(args.position) === 'next' ? 'next' : 'last'
        const playlist = str(args.playlist)
        return render(await execute(api, playlist ? `playlist-${suffix}` : `play-${suffix}`,
          playlist ? { name: playlist } : { title: str(args.title) }, context))
      }
    },
    {
      name: 'music_playlist', description: 'Create, rename, delete, clear, edit, play, or shuffle a playlist.',
      parameters: schema({
        action: { type: 'string', enum: ['create', 'rename', 'delete', 'clear', 'add_song', 'remove_song', 'set_cover', 'play', 'shuffle'] },
        name: text('Playlist name'), newName: text('New name'), song: text('Track title'),
        cover: text('Cover path'), shuffle: { type: 'boolean' }
      }, ['action', 'name']),
      sideEffect: 'write', commandDispatch: 'dynamic',
      run: async (args, context) => {
        const ids: Record<string, string> = {
          create: 'create-playlist', rename: 'rename-playlist', delete: 'delete-playlist', clear: 'clear-playlist',
          add_song: 'add-to-playlist', remove_song: 'remove-from-playlist', set_cover: 'set-cover',
          play: 'playlist', shuffle: 'playlist-shuffle'
        }
        const input = {
          name: str(args.name), playlist: str(args.name), newName: str(args.newName),
          query: str(args.song), cover: str(args.cover), shuffle: args.shuffle === true
        }
        return render(await execute(api, ids[str(args.action)] ?? 'playlist', input, context))
      }
    },
    {
      name: 'music_favorite', description: 'Favorite or unfavorite a track.',
      parameters: schema({ title: text('Track title; omit for current'), favorite: { type: 'boolean' } }),
      sideEffect: 'write', commandId: 'favorite',
      run: async (args, context) => render(await execute(api, 'favorite', {
        title: str(args.title), ...(bool(args.favorite) === undefined ? {} : { on: args.favorite })
      }, context))
    }
  ])
}
