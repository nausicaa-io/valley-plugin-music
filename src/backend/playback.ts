import type { DatasetRecord, PluginBackendApi } from '@valley/plugin-sdk'
import { VIDEO_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { trackCredits } from '../artists'
import { nextIndex, type MusicPlaybackAction, type MusicPlaybackSnapshot } from '../playback'
import type { RepeatMode, Track } from '../types'

type Player = Awaited<ReturnType<PluginBackendApi['playback']['createLocalPlayer']>>
type PlayerSnapshot = Awaited<ReturnType<Player['getSnapshot']>>

export class MusicPlayback {
  private queue: Track[] = []
  private index = -1
  private playlistId: string | null = null
  private shuffle = false
  private repeat: RepeatMode = 'off'
  private revision = 0
  private player: Player | null = null
  private media: PlayerSnapshot = null
  private sampledAt = 0
  private error: string | null = null
  private errorOutcome: 'unknown' | undefined
  private playEvent: MusicPlaybackSnapshot['playEvent']
  private pendingHistory = new Map<string, NonNullable<MusicPlaybackSnapshot['playEvent']>>()
  private endedGeneration: string | null = null
  private recordedGeneration: string | null = null
  private off: (() => void)[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private ready: Promise<void>
  private disposed = false
  private libraryDirty = false
  private refreshingLibrary = false

  constructor(private api: PluginBackendApi, private random = Math.random) {
    this.ready = this.initialize()
    void this.ready.catch(error => { this.error = this.message(error); this.publish() })
  }

  private async rows(dataset: string): Promise<DatasetRecord[]> {
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.api.data.dataset(dataset).query({ limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }

  private async tracks(ids?: string[]): Promise<Track[]> {
    const tracks = (await this.rows('music.tracks')) as unknown as Track[]
    if (!ids) return tracks
    const byId = new Map(tracks.map(track => [track.id, track]))
    return ids.map(id => {
      const track = byId.get(id)
      if (!track) throw new Error('A queued track no longer exists')
      return track
    })
  }

  private async initialize(): Promise<void> {
    const prefs = this.api.settings.get().player as Record<string, unknown> | undefined
    this.shuffle = prefs?.shuffle === true
    this.repeat = prefs?.repeat === 'all' || prefs?.repeat === 'one' ? prefs.repeat : 'off'
    const [tracks, saved] = await Promise.all([this.tracks(), this.rows('music.queue')])
    const byId = new Map(tracks.map(track => [track.id, track]))
    this.queue = saved.sort((a, b) => Number(a.position) - Number(b.position))
      .map(entry => byId.get(String(entry.songId))).filter((track): track is Track => Boolean(track))
    const player = await this.api.playback.createLocalPlayer({ id: 'music', canSkip: true })
    if (this.disposed) { await player.dispose(); return }
    this.player = player
    this.off.push(player.onChange(snapshot => this.observe(snapshot)))
    this.off.push(player.onAction(action => this.dispatch({ type: action === 'next' ? 'next' : 'previous' }).then(() => {})))
    const snapshot = await player.getSnapshot()
    const current = snapshot?.descriptor.path ? tracks.find(track => track.file === snapshot.descriptor.path) : undefined
    if (current) {
      this.queue = [current, ...this.queue]
      this.index = 0
      const data = snapshot?.descriptor.restorationData
      this.playlistId = data && typeof data === 'object' && !Array.isArray(data) && typeof data.playlistId === 'string' ? data.playlistId : null
    }
    this.observe(snapshot)
    this.off.push(this.api.data.dataset('music.tracks').subscribe(() => this.refreshLibrary()))
  }

  private refreshLibrary(): void {
    this.libraryDirty = true
    if (this.refreshingLibrary || this.disposed) return
    this.refreshingLibrary = true
    void this.enqueue(async () => {
      while (this.libraryDirty) {
        this.libraryDirty = false
        const tracks = new Map((await this.tracks()).map(track => [track.id, track]))
        this.queue = this.queue.map(track => tracks.get(track.id) ?? track)
        const track = this.queue[this.index]
        if (track && this.media?.descriptor.path && this.player) {
          const { title, artists, feat, artwork, restorationData } = this.resource(track)
          const patch = { title, artists, feat, artwork, restorationData }
          if (Object.entries(patch).some(([key, value]) => JSON.stringify(this.media?.descriptor[key as keyof NonNullable<PlayerSnapshot>['descriptor']]) !== JSON.stringify(value))) {
            const snapshot = await this.player.updateMetadata(patch)
            if (snapshot) this.observe(snapshot)
          }
        }
        await this.prepare()
        this.publish()
      }
    }).catch(error => { this.error = this.message(error); this.publish() }).finally(() => { this.refreshingLibrary = false; if (this.libraryDirty) this.refreshLibrary() })
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Music playback failed'
  }

  private observe(snapshot: PlayerSnapshot): void {
    if (this.disposed) return
    this.media = snapshot
    this.sampledAt = performance.now()
    this.error = snapshot?.state.error ?? null
    this.publish()
    if (!snapshot || snapshot.descriptor.path !== this.queue[this.index]?.file) return
    const generation = `${snapshot.target.sessionGeneration}:${snapshot.target.sourceGeneration}`
    if (snapshot.state.status === 'playing' && this.recordedGeneration !== generation) {
      this.recordedGeneration = generation
      const track = this.queue[this.index]
      const playlistId = this.playlistId
      const entry = { id: `play:${Date.now()}:${this.random().toString(36).slice(2)}`, songId: track.id, playedAt: new Date().toISOString(), ...(playlistId ? { playlistId } : {}) }
      this.pendingHistory.set(entry.id, entry)
      void this.enqueue(async () => {
        await this.flushHistory()
      }).catch(error => { this.error = this.message(error); this.publish() })
    }
    if (snapshot.state.status === 'ended' && this.endedGeneration !== generation) {
      this.endedGeneration = generation
      void this.enqueue(async () => {
        if (this.media?.target.sourceGeneration !== snapshot.target.sourceGeneration) return
        const index = this.repeat === 'one' ? this.index : nextIndex(this.queue.length, this.index, this.repeat)
        if (index !== null && this.queue[index]) await this.start(index)
      }).catch(error => { this.error = this.message(error); this.publish() })
    }
  }

  snapshot(): MusicPlaybackSnapshot {
    const state = this.media?.state
    return {
      revision: this.revision,
      sessionId: this.media?.target.sessionId ?? this.player?.sessionId ?? null,
      queue: [...this.queue], index: this.index, playlistId: this.playlistId,
      current: this.queue[this.index] ?? null,
      playing: state?.status === 'playing', buffering: state?.status === 'loading' || state?.status === 'buffering',
      position: state?.positionSeconds ?? 0, duration: state?.durationSeconds ?? this.queue[this.index]?.duration ?? 0,
      rate: state?.rate ?? 1, sampleAgeMs: (this.media?.sampleAgeMs ?? 0) + Math.max(0, performance.now() - this.sampledAt), volume: state?.volume ?? 0.8,
      shuffle: this.shuffle, repeat: this.repeat, error: this.error,
      ...(this.errorOutcome ? { errorOutcome: this.errorOutcome } : {}),
      ...(this.playEvent ? { playEvent: this.playEvent } : {})
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.revision++
    this.api.rpc.emit('playback.changed', this.snapshot())
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(async () => { await this.ready; if (this.disposed) throw new Error('Music playback disposed'); return run() })
    this.tail = result
    return result
  }

  async read(): Promise<MusicPlaybackSnapshot> {
    await this.ready
    return this.snapshot()
  }

  private resource(track: Track) {
    const credits = trackCredits(track)
    return {
      key: track.id, providerId: 'music', sourceId: 'music', path: track.file,
      kind: (VIDEO_EXTENSIONS as readonly string[]).includes(fileExtension(track.file)) ? 'video' as const : 'audio' as const,
      title: track.title, artists: credits.artists, feat: credits.feat,
      artwork: track.details?.cover || undefined,
      restorationData: { trackId: track.id, playlistId: this.playlistId }
    }
  }

  private async receipt(pending: ReturnType<Player['play']>): Promise<void> {
    const receipt = await pending
    if (receipt.status === 'failed' || receipt.status === 'rejected' || receipt.status === 'unknown') {
      throw Object.assign(new Error(receipt.status === 'unknown' ? 'Playback outcome is unknown. Check the player before trying again.' : 'The player could not complete the command'), receipt.status === 'unknown' ? { outcome: 'unknown', retryable: false } : {})
    }
  }

  private async start(index: number, position = 0): Promise<void> {
    const selected = this.queue[index]
    if (!selected || !this.player) return
    const track = await this.api.data.dataset('music.tracks').get({ id: selected.id }) as unknown as Track | null
    if (!track) throw new Error('A queued track no longer exists')
    this.queue[index] = track
    this.index = index
    this.error = null
    this.publish()
    const snapshot = await this.player.load(this.resource(track), { position, autoplay: true })
    if (!snapshot) throw Object.assign(new Error('Playback outcome is unknown. Check the player before trying again.'), { outcome: 'unknown', retryable: false })
    this.observe(snapshot)
    if (snapshot.state.status === 'error') throw new Error(snapshot.state.error ?? 'The player could not load this track')
    await this.persist()
    await this.prepare()
  }

  private async prepare(): Promise<void> {
    const following = this.repeat === 'one' ? this.index : nextIndex(this.queue.length, this.index, this.repeat)
    const track = following === null ? undefined : this.queue[following]
    await this.player?.prepareNext(track ? this.resource(track) : null)
  }

  private shuffleTail(base: number): void {
    for (let index = this.queue.length - 1; index > base; index--) {
      const other = base + Math.floor(this.random() * (index - base + 1))
      ;[this.queue[index], this.queue[other]] = [this.queue[other], this.queue[index]]
    }
  }

  private async persist(): Promise<void> {
    await this.flushHistory()
    const records = this.queue.slice(this.index + 1).map((track, position) => ({ position, songId: track.id }))
    const existing = await this.rows('music.queue')
    const previous = new Map(existing.map(entry => [Number(entry.position), String(entry.songId)]))
    const changed = records.filter(entry => previous.get(entry.position) !== entry.songId)
    const removed = existing.filter(entry => Number(entry.position) >= records.length).map(entry => ({ position: Number(entry.position) }))
    const operations = [
      ...(removed.length ? [{ operation: 'delete-many' as const, keys: removed }] : []),
      ...(changed.length ? [{ operation: 'upsert' as const, values: changed }] : [])
    ]
    if (operations.length) await this.api.data.dataset('music.queue').batch(operations)
    const preferences = this.api.settings.get().player as Record<string, unknown> | undefined
    if (preferences?.shuffle === this.shuffle && preferences?.repeat === this.repeat) return
    const saved = await this.api.settings.set('player', { ...(preferences ?? {}), shuffle: this.shuffle, repeat: this.repeat })
    if (!saved.ok) throw new Error('Could not save Music player preferences')
  }

  private async flushHistory(): Promise<void> {
    for (const [id, entry] of this.pendingHistory) {
      await this.api.data.dataset('music.play_events').upsert({ ...entry })
      this.pendingHistory.delete(id)
      this.playEvent = entry
      this.publish()
    }
  }

  dispatch(action: MusicPlaybackAction): Promise<MusicPlaybackSnapshot> {
    return this.enqueue(async () => {
      if (!this.player) throw new Error('Music player unavailable')
      this.errorOutcome = undefined
      const base = this.index + 1
      switch (action.type) {
        case 'start':
          this.queue = await this.tracks(action.ids)
          this.playlistId = action.playlistId ?? null
          if (action.shuffle) { this.shuffle = true; this.shuffleTail(0) }
          await this.start(action.index, action.position)
          break
        case 'toggle':
          if (this.media?.state.status === 'playing' || this.media?.state.status === 'buffering') await this.receipt(this.player.pause())
          else await this.resume()
          break
        case 'resume': await this.resume(); break
        case 'pause': if (this.media) await this.receipt(this.player.pause()); break
        case 'stop': if (this.media?.descriptor.path) await this.receipt(this.player.pause()); this.queue = this.queue.slice(0, base); break
        case 'next': {
          const index = this.repeat === 'one' ? this.index : nextIndex(this.queue.length, this.index, this.repeat)
          if (index !== null) await this.start(index)
          break
        }
        case 'previous':
          if ((this.media?.state.positionSeconds ?? 0) > 3) await this.receipt(this.player.seek(0))
          else if (this.index > 0) await this.start(this.index - 1)
          else if (this.repeat === 'all' && this.queue.length > 1) await this.start(this.queue.length - 1)
          else await this.receipt(this.player.seek(0))
          break
        case 'seek': await this.receipt(this.player.seek(action.value)); break
        case 'volume': await this.receipt(this.player.setVolume(action.value)); break
        case 'add': this.queue.splice(action.where === 'next' ? base : this.queue.length, 0, ...await this.tracks(action.ids)); break
        case 'remove': if (action.index >= 0) this.queue.splice(base + action.index, 1); break
        case 'reorder': {
          if (action.from < 0 || action.to < 0) break
          const [track] = this.queue.splice(base + action.from, 1)
          if (track) this.queue.splice(Math.min(base + action.to, this.queue.length), 0, track)
          break
        }
        case 'playQueued': if (action.index >= 0) await this.start(base + action.index); break
        case 'clear': this.queue = this.queue.slice(0, base); break
        case 'shuffle': this.shuffle = !this.shuffle; if (this.shuffle) this.shuffleTail(base); break
        case 'repeat': this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'; break
        case 'flush': break
      }
      await this.persist()
      await this.prepare()
      this.publish()
      return this.snapshot()
    }).catch(error => { this.error = this.message(error); this.errorOutcome = error?.outcome === 'unknown' ? 'unknown' : undefined; this.publish(); throw error })
  }

  private async resume(): Promise<void> {
    if (!this.player) return
    if (this.index >= 0 && this.media?.state.status !== 'ended') { await this.receipt(this.player.play()); return }
    if (this.queue.length) { await this.start(Math.max(0, this.index)); return }
    const history = (await this.rows('music.play_events')).sort((a, b) => String(a.playedAt).localeCompare(String(b.playedAt)))
    const last = history.at(-1)
    if (!last) return
    this.queue = await this.tracks([String(last.songId)])
    this.playlistId = typeof last.playlistId === 'string' ? last.playlistId : null
    await this.start(0)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.tail.catch(() => {})
    await this.ready.catch(() => {})
    this.disposed = true
    this.off.splice(0).forEach(off => off())
    await this.player?.dispose()
  }
}
